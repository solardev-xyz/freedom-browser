// Only the built-in ordinary start page loads this script. The banner walks a
// new user into Freedom Agent: "Set up" while AI is off, "Connect a model"
// while AI is on without one, and nothing once a model is connected. A user
// who connected a model and then turned AI off is told it is off rather than
// introduced to it again. Turning AI on stays in Settings, which is where the
// user consents to it. Dismissing the banner hides the step it was showing;
// Settings → AI can show it again.
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

const { aiInvitationStep, dismissedAiInvitationStep } = window.freedomAiInvitation;

let settings = null;
let revision = 0;
// The step the banner is showing, which the dismiss button hides.
let shown = null;

// A dismissal hides only the step it was made on (#881): reaching a different
// step (turning AI on, or off again after connecting a model) shows the banner
// again.
async function render() {
  if (!settings) return;
  const current = ++revision;
  const step = await aiInvitationStep(settings, () => freedomAPI.getAgentSetupState());
  if (current !== revision) return;
  shown = step && step !== dismissedAiInvitationStep(settings) ? step : null;
  banner.hidden = !shown;
  if (!shown) return;
  heading.textContent = STEPS[shown].heading;
  byline.textContent = STEPS[shown].byline;
  open.textContent = STEPS[shown].action;
  open.href = STEPS[shown].href;
}

function apply(next) {
  settings = next;
  void render();
}

dismiss.addEventListener('click', async () => {
  const step = shown;
  if (!step) return;
  dismiss.disabled = true;
  try {
    if (!(await freedomAPI.saveSettings({ aiInvitationDismissed: step }))) throw new Error();
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
