// Which Freedom Agent setup step the start-page banner is on, shared by the
// start page (home-ai.js, which shows the banner) and Settings → AI (which
// offers to show a dismissed banner again), so the two cannot disagree about
// whether the banner is hidden. Loaded as a classic script before either; it
// exports its helpers when `module` exists (Jest).
//
// The steps: "enable" while AI is off and no model is connected, "resume"
// while AI is off with a model still connected, "connect" while AI is on
// without one, and none once a model is connected. Settings stores the step a
// dismissal hid (`aiInvitationDismissed`, #881), so dismissing one step does
// not hide the later ones.
(function (root) {
  const AI_INVITATION_STEPS = ['enable', 'connect', 'resume'];

  // The step this profile is on, or null when there is nothing left to set up
  // (or, with AI on, the setup state could not be read, which hides it too).
  async function aiInvitationStep(settings, getAgentSetupState) {
    const enabled = settings?.enableAi === true;
    let configured;
    try {
      const state = await getAgentSetupState();
      configured = state?.ok ? state.configured === true : null;
    } catch {
      configured = null;
    }
    // With AI off an unreadable state falls back to the introduction.
    if (!enabled) return configured ? 'resume' : 'enable';
    if (configured === null) return null;
    return configured ? null : 'connect';
  }

  // The step a dismissal hid, or null when none was dismissed.
  function dismissedAiInvitationStep(settings) {
    const value = settings?.aiInvitationDismissed;
    return AI_INVITATION_STEPS.includes(value) ? value : null;
  }

  const api = { AI_INVITATION_STEPS, aiInvitationStep, dismissedAiInvitationStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.freedomAiInvitation = api;
})(typeof window !== 'undefined' ? window : globalThis);
