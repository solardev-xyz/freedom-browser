// Only the built-in ordinary start page loads this script. The banner walks a
// new user into Freedom Agent: "Set up" while AI is off, "Connect a model"
// while AI is on without one, and nothing once a model is connected. A user
// who connected a model and then turned AI off is told it is off rather than
// introduced to it again. Turning AI on stays in Settings, which is where the
// user consents to it.
const banner = document.getElementById('ai-invitation');
const intro = document.getElementById('home-intro');
const heading = document.getElementById('ai-invitation-heading');
const byline = document.getElementById('ai-invitation-byline');
const open = document.getElementById('ai-invitation-open');
const dismiss = document.getElementById('ai-invitation-dismiss');
const message = document.getElementById('ai-invitation-status');

const STEPS = {
  enable: {
    heading: 'Meet Freedom Agent',
    byline: 'Research, build and publish to the decentralized web.',
    action: 'Set up',
    href: 'freedom://settings/ai',
  },
  resume: {
    heading: 'Freedom Agent is off',
    byline: 'Your model is still connected. Turn AI on to use Agent again.',
    action: 'Turn on',
    href: 'freedom://settings/ai',
  },
  connect: {
    heading: 'Finish setting up Freedom Agent',
    byline: 'Connect a model to start researching, building and publishing.',
    action: 'Connect a model',
    href: 'freedom://settings/ai/providers/add',
  },
};

let settings = null;
let revision = 0;

// The step this profile is on, or null when there is nothing left to set up
// (or, with AI on, the setup state could not be read, which hides it too).
async function currentStep() {
  const enabled = settings?.enableAi === true;
  let configured;
  try {
    const state = await freedomAPI.getAgentSetupState();
    configured = state?.ok ? state.configured === true : null;
  } catch {
    configured = null;
  }
  // With AI off an unreadable state falls back to the introduction.
  if (!enabled) return configured ? 'resume' : 'enable';
  if (configured === null) return null;
  return configured ? null : 'connect';
}

async function render() {
  if (!settings) return;
  const current = ++revision;
  const step = settings.aiInvitationDismissed === true ? null : await currentStep();
  if (current !== revision) return;
  banner.hidden = !step;
  if (!step) return;
  heading.textContent = STEPS[step].heading;
  byline.textContent = STEPS[step].byline;
  open.textContent = STEPS[step].action;
  open.href = STEPS[step].href;
}

function apply(next) {
  settings = next;
  void render();
}

dismiss.addEventListener('click', async () => {
  dismiss.disabled = true;
  try {
    if (!(await freedomAPI.saveSettings({ aiInvitationDismissed: true }))) throw new Error();
    banner.hidden = true;
    // The banner disappeared; return keyboard focus to the introduction.
    intro.focus();
  } catch {
    message.textContent = 'Could not hide this banner. Please try again.';
  } finally {
    dismiss.disabled = false;
  }
});
freedomAPI.onSettingsUpdated?.(apply);
// A model connected or removed in Settings changes the step.
freedomAPI.onAgentProviderChanged?.(() => void render());
freedomAPI
  .getSettings()
  .then(apply)
  .catch(() => {
    // Keep the banner hidden when its saved state cannot be loaded.
  });
