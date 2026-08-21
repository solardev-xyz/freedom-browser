const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { updateActiveProfileNodeConfig } = require('./profile-resolver');
const { probeSocks5Endpoint } = require('./socks-probe');

const EXTERNAL_CANDIDATE_PROMPT_KEY = 'externalCandidatePrompt';

const DEFAULT_EXTERNAL_NODE_CANDIDATES = {
  bee: {
    label: 'Swarm',
    endpoints: ['http://127.0.0.1:1633'],
    externalConfig: {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
    },
    probes: [
      {
        url: 'http://127.0.0.1:1633/health',
        method: 'GET',
        expectJson: true,
      },
    ],
  },
  radicle: {
    label: 'Radicle',
    endpoints: ['http://127.0.0.1:8780'],
    externalConfig: {
      mode: 'external',
      externalHttp: 'http://127.0.0.1:8780',
    },
    probes: [
      {
        url: 'http://127.0.0.1:8780/',
        method: 'GET',
      },
    ],
  },
  tor: {
    label: 'Tor',
    endpoints: ['SOCKS5 127.0.0.1:9150'],
    externalConfig: {
      mode: 'external',
      externalSocks: '127.0.0.1:9150',
    },
    probes: [
      {
        type: 'socks5',
        endpoint: '127.0.0.1:9150',
      },
    ],
  },
};

function getHttpClient(url) {
  return url.startsWith('https:') ? https : http;
}

function probeEndpoint(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  if (probe.type === 'socks5') {
    return probeSocks5Endpoint(probe.endpoint, { timeoutMs });
  }

  return new Promise((resolve) => {
    const parsed = new URL(probe.url);
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: probe.method || 'GET',
      headers: probe.method === 'POST' ? { 'Content-Length': 0 } : undefined,
      timeout: timeoutMs,
    };

    const req = getHttpClient(probe.url).request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (probe.acceptAnyHttpResponse) {
          resolve(true);
          return;
        }

        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }

        if (!probe.expectJson) {
          resolve(true);
          return;
        }

        try {
          JSON.parse(data);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      res.resume();
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function shouldPromptForProtocol(profile, protocol) {
  const config = profile?.metadata?.nodes?.[protocol];
  return config?.mode === 'managed' && !config?.[EXTERNAL_CANDIDATE_PROMPT_KEY]?.choice;
}

async function detectDefaultExternalCandidates(profile, options = {}) {
  const candidates = [];
  const probe = options.probeEndpoint || probeEndpoint;
  const definitions = options.candidates || DEFAULT_EXTERNAL_NODE_CANDIDATES;

  for (const [protocol, definition] of Object.entries(definitions)) {
    if (options.enabledProtocols && options.enabledProtocols[protocol] === false) continue;
    if (!shouldPromptForProtocol(profile, protocol)) continue;

    const results = await Promise.all(
      definition.probes.map((candidateProbe) => probe(candidateProbe, options))
    );
    if (results.every(Boolean)) {
      candidates.push({
        protocol,
        ...definition,
      });
    }
  }

  return candidates;
}

function buildPromptMarker(choice, candidate, now = new Date().toISOString()) {
  return {
    choice,
    checkedAt: now,
    endpoints: candidate.endpoints,
  };
}

function serializeCandidate(candidate) {
  return {
    protocol: candidate.protocol,
    label: candidate.label,
    endpoints: candidate.endpoints,
  };
}

function normalizeChoice(choice) {
  return choice === 'external' ? 'external' : 'managed';
}

function applyExternalCandidateDecisions(candidates, choices = {}, options = {}) {
  const updateNodeConfig = options.updateNodeConfig || updateActiveProfileNodeConfig;
  const logger = options.logger || console;
  const decisions = [];

  for (const candidate of candidates) {
    const choice = normalizeChoice(choices[candidate.protocol]);
    const marker = buildPromptMarker(choice, candidate, options.now);
    const updates = choice === 'external'
      ? { ...candidate.externalConfig, [EXTERNAL_CANDIDATE_PROMPT_KEY]: marker }
      : { [EXTERNAL_CANDIDATE_PROMPT_KEY]: marker };

    updateNodeConfig(candidate.protocol, updates);
    decisions.push({
      protocol: candidate.protocol,
      choice,
      endpoints: candidate.endpoints,
    });
    logger.info?.('[profile] Default-port external node decision:', {
      protocol: candidate.protocol,
      choice,
      endpoints: candidate.endpoints,
    });
  }

  return decisions;
}

function managedChoicesFor(candidates) {
  return Object.fromEntries(candidates.map((candidate) => [candidate.protocol, 'managed']));
}

function singleEnabledProtocol(protocol, definitions = DEFAULT_EXTERNAL_NODE_CANDIDATES) {
  return Object.fromEntries(
    Object.keys(definitions).map((candidateProtocol) => [
      candidateProtocol,
      candidateProtocol === protocol,
    ])
  );
}

function waitForWindowLoad(window) {
  if (!window || window.isDestroyed?.()) {
    return Promise.resolve(false);
  }

  const webContents = window.webContents;
  if (!webContents) {
    return Promise.resolve(false);
  }

  if (typeof webContents.isLoading === 'function' && !webContents.isLoading()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      webContents.removeListener?.('did-finish-load', onReady);
      webContents.removeListener?.('did-fail-load', onFailed);
      window.removeListener?.('closed', onClosed);
    };
    const onReady = () => {
      cleanup();
      resolve(!window.isDestroyed?.());
    };
    const onFailed = () => {
      cleanup();
      resolve(false);
    };
    const onClosed = () => {
      cleanup();
      resolve(false);
    };

    webContents.once?.('did-finish-load', onReady);
    webContents.once?.('did-fail-load', onFailed);
    window.once?.('closed', onClosed);
  });
}

async function presentExternalCandidatesInWindow(profile, candidates, options = {}) {
  const window = options.window;
  if (!window || window.isDestroyed?.() || !window.webContents) {
    return null;
  }

  const isLoaded = await waitForWindowLoad(window);
  if (!isLoaded || window.isDestroyed?.()) {
    return managedChoicesFor(candidates);
  }

  const requestId = options.requestId || crypto.randomBytes(16).toString('hex');
  const ipc = options.ipcMain || ipcMain;
  const expectedSender = window.webContents;
  return new Promise((resolve) => {
    const finish = (choices) => {
      ipc.removeListener(IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, onDecision);
      window.removeListener?.('closed', onClosed);
      resolve(choices || managedChoicesFor(candidates));
    };
    const onDecision = (_event, payload = {}) => {
      if (payload.requestId !== requestId) return;
      if (_event?.sender !== expectedSender) return;
      finish(payload.choices);
    };
    const onClosed = () => {
      finish(managedChoicesFor(candidates));
    };

    ipc.on(IPC.PROFILE_EXTERNAL_CANDIDATES_DECISION, onDecision);
    window.once?.('closed', onClosed);
    window.webContents.send(IPC.PROFILE_EXTERNAL_CANDIDATES, {
      requestId,
      profile: {
        id: profile.id,
        displayName: profile.displayName || profile.id,
      },
      candidates: candidates.map(serializeCandidate),
    });
  });
}

async function promptForDefaultExternalCandidates(profile, options = {}) {
  if (!profile || profile.source !== 'catalog') return [];

  const logger = options.logger || console;
  const dialog = options.dialog || require('electron').dialog;
  const candidates = await detectDefaultExternalCandidates(profile, options);
  if (!candidates.length) return [];

  const rendererChoices = options.presentCandidates
    ? await options.presentCandidates(profile, candidates, options)
    : await presentExternalCandidatesInWindow(profile, candidates, options);
  if (rendererChoices) {
    return applyExternalCandidateDecisions(candidates, rendererChoices, options);
  }

  const decisions = [];
  for (const candidate of candidates) {
    const profileName = profile.displayName || profile.id;
    const endpointText = candidate.endpoints.join(' and ');
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Use External Node', 'Keep Managed Node'],
      defaultId: 1,
      cancelId: 1,
      title: `Use existing ${candidate.label} node?`,
      message: `Freedom found an existing ${candidate.label} node at ${endpointText}.`,
      detail:
        `Use it for the "${profileName}" profile, or keep this profile independent ` +
        'with a Freedom-managed node on profile-specific ports.',
    });

    const choice = result.response === 0 ? 'external' : 'managed';
    decisions.push(...applyExternalCandidateDecisions(
      [candidate],
      { [candidate.protocol]: choice },
      { ...options, logger }
    ));
  }

  return decisions;
}

function promptForDefaultExternalCandidateProtocol(profile, protocol, options = {}) {
  const definitions = options.candidates || DEFAULT_EXTERNAL_NODE_CANDIDATES;
  if (!definitions[protocol]) return Promise.resolve([]);
  return promptForDefaultExternalCandidates(profile, {
    ...options,
    enabledProtocols: singleEnabledProtocol(protocol, definitions),
  });
}

module.exports = {
  DEFAULT_EXTERNAL_NODE_CANDIDATES,
  EXTERNAL_CANDIDATE_PROMPT_KEY,
  applyExternalCandidateDecisions,
  buildPromptMarker,
  detectDefaultExternalCandidates,
  probeEndpoint,
  presentExternalCandidatesInWindow,
  promptForDefaultExternalCandidateProtocol,
  promptForDefaultExternalCandidates,
  shouldPromptForProtocol,
};
